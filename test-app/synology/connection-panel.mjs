import {connectionView,modeAvailability,modes,checkSynology} from './connection-state.mjs';

export function mountConnectionPanel(host,doc=document,events=globalThis) {
  const header=doc.querySelector('#mainHeader .version-label');
  const settings=doc.querySelector('#admin-sub-appsettings');
  if(!header||!settings)return ()=>{};
  const style=doc.createElement('style');
  style.textContent=`.server-source{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;border:1px solid var(--border);background:#475569;color:white;font-size:12px;font-weight:800;flex-shrink:0}.server-source[data-source=firebase]{background:#92400e}.server-source[data-source=synology]{background:#166534}.server-connection-note{font-size:12px;line-height:1.5;color:var(--muted);margin:10px 0}.server-connection-result{white-space:pre-wrap;font-size:12px;line-height:1.5;margin-top:10px}`;
  doc.head.append(style);
  const badge=doc.createElement('button');badge.type='button';badge.className='server-source';badge.textContent='…';badge.setAttribute('aria-label','Проверка источника данных');header.append(badge);
  const panel=doc.createElement('details');panel.className='admin-settings-group';
  panel.innerHTML='<summary>Сервер данных<span>Подключение тестовой версии</span></summary><div class="form-card"><label for="test-server-mode">Режим подключения</label><select id="test-server-mode" class="form-control"></select><p class="server-connection-note" data-mode-note></p><p class="server-connection-note">Выбор относится к этому устройству. Firebase для входа не определяет источник данных.</p><button type="button" class="btn btn-secondary" data-server-check>Проверить Synology</button><div class="server-connection-result" role="status" aria-live="polite"></div></div>';
  settings.prepend(panel);
  const select=panel.querySelector('select'),note=panel.querySelector('[data-mode-note]'),check=panel.querySelector('[data-server-check]'),result=panel.querySelector('[role=status]');
  for(const [id,label] of Object.entries(modes)){const option=doc.createElement('option');option.value=id;option.textContent=label;select.append(option);}
  let stopped=false,busy=false,lastUid=null,epoch=0;
  function refresh() {
    const state=host.status();
    if(state.uid!==lastUid){lastUid=state.uid;epoch++;result.textContent='';}
    const view=connectionView(state);badge.textContent=view.letter;badge.dataset.source=view.source;badge.title=view.label;badge.setAttribute('aria-label',view.label);
    panel.hidden=!state.admin;
    select.value='firebase';
    for(const option of select.options){const reason=modeAvailability(option.value,{pending:state.pending});option.disabled=!!reason;option.title=reason||'';}
    note.textContent='Сейчас используется Firebase. Synology станет доступен после подключения всех экранов; автоматический режим — после проверки резерва.';
    check.disabled=!state.admin||!state.online||busy;
  }
  // This release has only one complete business adapter. Do not pretend that
  // changing a dropdown changes the backend or move an existing local queue.
  select.addEventListener('change',()=>{select.value='firebase';refresh();});
  badge.addEventListener('click',()=>host.diagnostics());
  async function probe() {
    const start=host.status();if(busy||!start.admin||!start.online)return;
    busy=true;const uid=start.uid,requestEpoch=epoch;
    result.textContent='Проверка линии и табеля Synology…';refresh();
    const guard=()=>{const s=host.status();if(stopped||requestEpoch!==epoch||s.uid!==uid||!s.admin)throw Error('Сеанс изменился');};
    try{const counts=await checkSynology({getIdToken:host.getIdToken,guard});guard();result.textContent=`Линия и табель доступны. Машин: ${counts.trucks}; обычных рейсов: ${counts.normal}; объём: ${counts.volume} м³.\nЭто проверка NAS; данные программы пока остаются в Firebase.`;}
    catch(error){if(!stopped&&requestEpoch===epoch&&host.status().uid===uid&&host.status().admin)result.textContent=error.status===404?'По внешнему адресу новый API табеля недоступен. Нужно проверить HTTPS-маршрут на Synology.':error.name==='AbortError'?'Synology не ответил вовремя. Данные программы остаются в Firebase.':error.message;}
    finally{busy=false;if(!stopped)refresh();}
  }
  check.addEventListener('click',probe);
  const timer=setInterval(refresh,1000);
  events.addEventListener('online',refresh);events.addEventListener('offline',refresh);refresh();
  return ()=>{stopped=true;epoch++;clearInterval(timer);events.removeEventListener('online',refresh);events.removeEventListener('offline',refresh);badge.remove();panel.remove();style.remove();};
}
