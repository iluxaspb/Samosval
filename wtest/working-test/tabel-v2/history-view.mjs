import {conflictRows} from './conflict-view.mjs';
import {esc} from './messages.mjs';
const value=x=>x===undefined?'не указано':x===null||x===''?'не заполнено':x===true?'да':x===false?'нет':String(x);
export function historyRows(h,config={}){
 const after=h.resolution==='theirs'?h.remote?.data:(h.data??h.after?.data);
 const changes=conflictRows(h.before?.data,h.before?.data,after,config);
 const date=after?.date||h.before?.data?.date;
 const decision=h.resolution==='mine'?'Решение: отправить вариант с этого устройства.':h.resolution==='theirs'?'Решение: оставить серверный вариант.':'';
 return `<article class="tn-history-row"><p><b>${esc(h.author?.name||h.author?.uid||'Автор не записан')}</b> · ${new Date(h.resolvedAt||h.time).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})}${date?' · '+esc(date)+' · '+(after?.shift==='night'?'Ночь':'День'):''}</p><p>${esc(h.label||'Изменение табеля')}. ${decision}</p>${changes.map(r=>`<p>${esc(r.label)}: было <b>${esc(value(r.before))}</b>, стало <b>${esc(value(r.mine))}</b>.</p>`).join('')||'<p>Значения не изменились.</p>'}${h.resolution?'<p>Другой вариант: '+conflictRows(after,after,h.resolution==='theirs'?h.data:h.remote?.data,config).map(r=>esc(r.label)+': '+esc(value(r.mine))).join('; ')+'. Оба варианта сохранены в журнале решения.</p>':''}</article>`;
}
