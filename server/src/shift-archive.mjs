import {fail} from './tabel-access.mjs';
export function linePeriod(shift) {
  let date=String(shift.startDate||'').trim();
  const ru=/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(date);
  if(ru)date=`${ru[3]}-${ru[2].padStart(2,'0')}-${ru[1].padStart(2,'0')}`;
  const parsed=new Date(date+'T12:00:00Z');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==date)throw fail('invalid-shift-date',409);
  let kind=shift.workShift||shift.kind;
  if(!['day','night'].includes(kind)){
    if(!Number.isFinite(Number(shift.startedAt))||!Number(shift.startedAt))throw fail('unknown-shift-period',409);
    const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Moscow',hour:'2-digit',hourCycle:'h23'}).format(new Date(Number(shift.startedAt))));
    kind=hour>=8&&hour<20?'day':'night';
  }
  return {date,kind};
}
export function buildShiftArchive(shift,logs,statuses,now=Date.now()) {
  if(!shift?.id||logs.some(log=>log.shiftId!==shift.id)||Object.values(statuses).some(st=>st.shiftId!==shift.id))throw fail('foreign-shift-data',409);
  if(!logs.length)return null;
  const byTruck=new Map();
  for(const log of logs){
    if(!log.id||!log.truckId||!Number.isFinite(Number(log.timestamp))||!Number.isFinite(Number(log.volume??0))||Number(log.volume??0)<0)throw fail('invalid-trip-data',409);
    if(!byTruck.has(log.truckId))byTruck.set(log.truckId,[]);
    byTruck.get(log.truckId).push(log);
  }
  for(const rows of byTruck.values())rows.sort((a,b)=>Number(a.timestamp)-Number(b.timestamp)||a.id.localeCompare(b.id));
  const returnedAt=log=>{
    const start=Number(log.timestamp),next=byTruck.get(log.truckId).find(row=>Number(row.timestamp)>start),st=statuses[log.truckId];
    const end=Number(log.returnedAt)||(next?Number(next.arrivalTimestamp):st?Number(st.arriveTimestamp):0);
    return start>0&&end>start&&end<=now&&(!next||end<=Number(next.timestamp))?end:null;
  };
  const activeLineIds=[],ttnStatus={};
  for(const [id,st] of Object.entries(statuses)){
    if(st.onLine)activeLineIds.push(id);
    if(st.ttnStatus!==undefined&&st.ttnStatus!==null)ttnStatus[id]=st.ttnStatus;
  }
  const ordinary=logs.filter(l=>!l.isGAI);
  return {sourceShiftId:shift.id,objectName:shift.objectName||'',objectId:shift.objectId||'',date:shift.startDate||'',closedAt:shift.closingStartedAt,closedBy:shift.closingBy,
    logs:logs.map(l=>({id:l.id,truckId:l.truckId,truckName:l.truckName||'',volume:l.volume??0,timeStr:l.timeStr||'',timestamp:l.timestamp,arrivalTimestamp:Number(l.arrivalTimestamp)||null,returnedAt:returnedAt(l),createdBy:l.createdBy||'',createdByEmail:l.createdByEmail||'',isGAI:!!l.isGAI,comment:l.comment||''})),
    activeLineIds,ttnStatus,totalVolume:ordinary.reduce((sum,l)=>sum+Number(l.volume||0),0),totalTrips:ordinary.length};
}
export function requireMaterialImport(shift,archive,row) {
  if(!archive?.totalTrips)return;
  const imported=row?.data?.lineImports?.[shift.id];
  if(!imported||imported.volume!==Number(archive.totalVolume)||typeof imported.materialId!=='string'||!imported.materialId)throw fail('material-not-confirmed',409);
}
