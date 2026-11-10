export const esc = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const button=(label,action,extra='')=>`<button type="button" data-t="${action}" ${extra}>${esc(label)}</button>`;
export const field=(label,control)=>`<label class="tb-field"><span>${esc(label)}</span>${control}</label>`;
export const input=(name,value='',extra='')=>`<input name="${esc(name)}" value="${esc(value)}" ${extra}>`;
export function showError(root,error){root.querySelector('[data-error]').textContent=error.message||String(error);}
export function formDialog(title,body,onSubmit){
  const el=document.createElement('dialog');el.className='tb tb-dialog';el.innerHTML=`<form><header><b>${esc(title)}</b>${button('×','close','aria-label="Закрыть"')}</header><main>${body}<p data-error role="alert"></p></main><footer>${onSubmit?'<button type="submit">Сохранить на устройстве</button>':''}${button('Закрыть','close')}</footer></form>`;
  document.body.append(el);el.querySelectorAll('[data-t=close]').forEach(b=>b.onclick=()=>el.close());el.addEventListener('close',()=>el.remove());
  el.querySelector('form').onsubmit=async e=>{e.preventDefault();if(!onSubmit)return;const b=el.querySelector('[type=submit]');b.disabled=true;try{await onSubmit(new FormData(e.target),el);el.close();}catch(err){showError(el,err);}finally{b.disabled=false;}};
  el.showModal();return el;
}
export async function messagePreview(title,text){
  const el=formDialog(title,`<textarea class="tb-message" aria-label="Предпросмотр сообщения">${esc(text)}</textarea><p data-share-status role="status">Сообщение подготовлено. Изменение текста не меняет данные объекта.</p><div class="tb-tools">${button('Поделиться','share')}${button('Скопировать текст','copy')}</div>`);
  const area=el.querySelector('textarea'),status=el.querySelector('[data-share-status]');
  el.querySelector('[data-t=share]').onclick=async()=>{if(!navigator.share){status.textContent='Системное меню недоступно. Используйте «Скопировать текст».';return;}try{status.textContent='Открываем системное меню…';await navigator.share({title,text:area.value});status.textContent='Системное меню закрыто. Доставка сообщения не подтверждена.';}catch(e){status.textContent=e.name==='AbortError'?'Отправка отменена. Текст сохранён в предпросмотре.':'Не удалось открыть меню. Используйте «Скопировать текст».';}};
  el.querySelector('[data-t=copy]').onclick=async()=>{try{await navigator.clipboard.writeText(area.value);status.textContent='Текст скопирован.';}catch{area.focus();area.select();status.textContent='Выделен текст. Нажмите «Копировать» в меню клавиатуры.';}};
  return el;
}
