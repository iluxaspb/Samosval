// TEST 4.1 cold archive at 23:00 Pacific local time, once per calendar day.
// Invoked by a separately installed trusted NAS scheduler; no live failover.
// Persist 'previous' on NAS only after a verified cycle. Never trust browser data.
import {captureReserveSnapshot,encodeReserveCheckpoint} from './reserve-checkpoint.mjs';

export const COLD_BACKUP_ZONE='America/Los_Angeles';
export const COLD_BACKUP_HOUR=23;
const pacificFormatter=new Intl.DateTimeFormat('en-US',{
  timeZone:COLD_BACKUP_ZONE,year:'numeric',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',hourCycle:'h23'
});
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const instant=value=>Number.isSafeInteger(value)&&value>=0;
const validDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&
  !Number.isNaN(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
function pacificParts(utcMs){
  const parts=Object.fromEntries(pacificFormatter.formatToParts(new Date(utcMs))
    .filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
  return {year:parts.year,month:parts.month,day:parts.day,hour:parts.hour,minute:parts.minute};
}
function dateKey({year,month,day}){
  return [year,String(month).padStart(2,'0'),String(day).padStart(2,'0')].join('-');
}
function shiftDay(key,days){
  const date=new Date(key+'T00:00:00Z');
  date.setUTCDate(date.getUTCDate()+days);
  return date.toISOString().slice(0,10);
}
// Resolve 23:00 local Pacific to UTC, including daylight-saving changes.
function pacific23AsUtc(dayKey){
  const target=Date.parse(dayKey+'T23:00:00Z');
  let value=target;
  for(let i=0;i<4;i++){
    const local=pacificParts(value);
    const represented=Date.UTC(local.year,local.month-1,local.day,local.hour,local.minute);
    const delta=target-represented;
    if(delta===0)break;
    value+=delta;
  }
  const actual=pacificParts(value);
  if(dateKey(actual)!==dayKey||actual.hour!==COLD_BACKUP_HOUR||actual.minute!==0)
    throw Error('pacific-schedule-conversion-failed');
  return value;
}
// Missed daily slots can catch up. Repeated calls for one slot do not upload again.
export function planColdBackup({now,previous=null}={}){
  if(!instant(now))throw TypeError('invalid-cold-backup-schedule');
  const pacific=pacificParts(now);
  const today=dateKey(pacific);
  const slotKey=pacific.hour>=COLD_BACKUP_HOUR?today:shiftDay(today,-1);
  if(previous!==null&&(!instant(previous.verifiedAt)||previous.verifiedAt>now||
    !digest(previous.hash)||!validDay(previous.slotKey)||previous.slotKey>slotKey))
    throw TypeError('invalid-cold-backup-receipt');
  const nextDueAt=pacific23AsUtc(shiftDay(slotKey,1));
  return {due:previous===null||previous.slotKey<slotKey,slotKey,
    scheduledAt:pacific23AsUtc(slotKey),nextDueAt,
    timeZone:COLD_BACKUP_ZONE,hour:COLD_BACKUP_HOUR};
}
export async function runColdBackupCycle({pool,store,now=Date.now(),previous=null,
  capture=captureReserveSnapshot}={}){
  const plan=planColdBackup({now,previous});
  if(!plan.due)return {status:'not-due',...plan,failoverEnabled:false};
  if(!pool||typeof store?.put!=='function'||typeof store.verify!=='function'||typeof capture!=='function')
    throw TypeError('invalid-cold-backup-services');
  const snapshot=await capture(pool);
  const hash=encodeReserveCheckpoint(snapshot).manifest.hash;
  let checkpoint;
  // An identical dataset does not need new Firebase writes, only verification.
  if(previous?.hash===hash){
    checkpoint={hash};
    if(!await store.verify(checkpoint))throw Error('cold-backup-readback-not-verified');
  }else{
    checkpoint=await store.put(snapshot);
    if(checkpoint?.hash!==hash||!await store.verify(checkpoint))
      throw Error('cold-backup-readback-not-verified');
  }
  // An immutable archive does not prove NAS remained unchanged while uploading.
  const latest=await capture(pool);
  if(encodeReserveCheckpoint(latest).manifest.hash!==hash)
    throw Error('cold-backup-source-changed');
  const receipt=Object.freeze({hash,verifiedAt:now,slotKey:plan.slotKey});
  return {status:previous?.hash===hash?'unchanged':'archived',
    receipt,timeZone:plan.timeZone,hour:plan.hour,
    failoverEnabled:false,liveReplicaVerified:false,nextDueAt:plan.nextDueAt};
}
