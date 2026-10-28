import * as D from './domain.mjs';
import {button,field,input,formDialog,messagePreview,showError} from './ui.mjs';
export function lineSnapshot(snapshot,objectId,day,coverage={confirmed:false}){
  let ambiguous=false;const rows=[],trucks=new Map((snapshot.trucks||[]).map(t=>[t.id,t])),shift=snapshot.shift;
  const match=event=>event.objectId===objectId&&((event.date||event.startDate||'').slice(0,10)===day||(event.timestamp&&new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow'}).format(new Date(event.timestamp))===day));
  // Existing audit omits wantArrived; only its explicit positive arrival label is evidence.
  for(const event of snapshot.audit||[])if(match(event)&&event.eventType==='arrive'&&!String(event.text||'').includes('Прибытие на линию')&&!String(event.text||'').includes('Снято прибытие на линию'))ambiguous=true;
  for(const event of snapshot.audit||[])if(match(event)&&event.eventType==='arrive'&&String(event.text||'').includes('Прибытие на линию')){const t=trucks.get(event.truckId)||{};if(!trucks.has(event.truckId)&&typeof event.isGAI!=='boolean')ambiguous=true;rows.push({id:event.truckId,name:t.name||event.truckName,plate:t.plate||t.number||event.truckName,isGAI:!!(t.isGAI||event.isGAI),arrived:true});}
  const shiftDay=String(shift?.startDate||'').slice(0,10);
  if(shift?.objectId===objectId&&shiftDay===day){for(const [id,st]of Object.entries(snapshot.statuses||{})){if(st.shiftId!==shift.id||!st.arriveTimestamp)continue;const t=trucks.get(id)||{};rows.push({id,name:t.name,plate:t.plate||t.number||t.name,isGAI:!!t.isGAI,arrived:true});}}
  for(const archive of snapshot.archive||[])if(match(archive))for(const l of archive.logs||[])if(l.arrivalTimestamp){const t=trucks.get(l.truckId)||{};rows.push({id:l.truckId,name:l.truckName,plate:t.plate||t.number||l.truckName,isGAI:!!(l.isGAI||t.isGAI),arrived:true});}
  // A bounded read of the full day's audit avoids the host's latest-200 limit.
  // Missing historical events still cannot be reconstructed.
  return {rows,complete:!!coverage.confirmed&&!ambiguous,note:coverage.note||(ambiguous?'В старых событиях недостаточно данных о прибытии или принадлежности к ГАИ. Итог требует проверки.':'')};
}
export async function dailyReport(s){
  s.require('report');const el=formDialog('Ежедневный отчёт',`<div class="tb-tools">${[['Сегодня',0],['Вчера',-1],['Позавчера',-2]].map(([t,n])=>button(t,'date',`data-offset="${n}"`)).join('')}</div>${field('Дата отчёта',input('day',s.ctx.date,'type="date"'))}<textarea class="tb-message" aria-label="Текст отчёта"></textarea><p class="tb-small">Фактические часы и объёмы не подменяются заявкой. Для самосвалов читается журнал выбранного дня. Ограничение источника указывается в тексте, если он недоступен или неполон.</p>${button('Предпросмотр и поделиться','preview')}`);
  let seq=0;
  async function update(){const ticket=++seq,day=el.querySelector('[name=day]').value;try{D.date(day);await s.loadPeriod(day,day);if(ticket!==seq||!el.isConnected)return;const history=s.api.lineHistory?await s.api.lineHistory(s.ctx.object.id,day):{audit:[],confirmed:false};if(ticket!==seq||!el.isConnected)return;const snapshot=s.api.line();snapshot.audit=[...(snapshot.audit||[]),...history.audit];const text=D.report({object:s.ctx.object,day,entries:s.rows('timesheetEntries'),values:s.rows('timesheetValues'),config:s.config,line:lineSnapshot(snapshot,s.ctx.object.id,day,history)});el.querySelector('textarea').value=text;}catch(e){if(ticket===seq)showError(el,e);}}
  el.querySelectorAll('[data-offset]').forEach(b=>b.onclick=()=>{el.querySelector('[name=day]').value=D.addDays(D.isoToday(),Number(b.dataset.offset));update();});el.querySelector('[name=day]').onchange=update;
  el.querySelector('[data-t=preview]').onclick=()=>messagePreview('Отчёт',el.querySelector('textarea').value);await update();return el;
}
