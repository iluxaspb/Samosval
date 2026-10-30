// Scheduled TEST cold archives: not continuous replication or a Firebase writer.
// Invoked by a separately configured trusted NAS scheduler; no implicit timers.
// Persist 'previous' on NAS only AFTER a successful cycle, never trust a device.
import {captureReserveSnapshot,encodeReserveCheckpoint} from './reserve-checkpoint.mjs';

export const COLD_BACKUP_PERIODS=Object.freeze({
  daily:24*60*60*1000,
  twiceDaily:12*60*60*1000
});
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const instant=value=>Number.isSafeInteger(value)&&value>=0;
export function planColdBackup({now,previous=null,cadence='twiceDaily'}={}){
  if(!instant(now)||!Object.hasOwn(COLD_BACKUP_PERIODS,cadence))throw TypeError('invalid-cold-backup-schedule');
  if(previous!==null&&(!instant(previous.verifiedAt)||previous.verifiedAt>now||
    !digest(previous.hash)))throw TypeError('invalid-cold-backup-receipt');
  if(previous&&now-previous.verifiedAt<COLD_BACKUP_PERIODS[cadence])
    return {due:false,nextDueAt:previous.verifiedAt+COLD_BACKUP_PERIODS[cadence],cadence};
  return {due:true,nextDueAt:now,cadence};
}
export async function runColdBackupCycle({pool,store,now=Date.now(),previous=null,cadence='twiceDaily',
  capture=captureReserveSnapshot}={}){
  const plan=planColdBackup({now,previous,cadence});
  if(!plan.due)return {status:'not-due',...plan,failoverEnabled:false};
  if(!pool||typeof store?.put!=='function'||typeof store.verify!=='function'||typeof capture!=='function')
    throw TypeError('invalid-cold-backup-services');
  const snapshot=await capture(pool);
  const hash=encodeReserveCheckpoint(snapshot).manifest.hash;
  let checkpoint;
  // An unmodified database need not be written again. Still read back the
  // previous immutable Firestore snapshot so a missing/corrupt archive fails.
  if(previous?.hash===hash){
    checkpoint={hash};
    if(!await store.verify(checkpoint))throw Error('cold-backup-readback-not-verified');
  }else{
    checkpoint=await store.put(snapshot);
    if(checkpoint?.hash!==hash||!await store.verify(checkpoint))
      throw Error('cold-backup-readback-not-verified');
  }
  // Changes during an upload or while verifying immutable chunks cannot
  // certify a fresh source. Never turn a cold backup into a live replica.
  const latest=await capture(pool);
  if(encodeReserveCheckpoint(latest).manifest.hash!==hash)
    throw Error('cold-backup-source-changed');
  const receipt=Object.freeze({hash,verifiedAt:now});
  return {status:previous?.hash===hash?'unchanged':'archived',
    receipt,cadence,failoverEnabled:false,liveReplicaVerified:false,
    nextDueAt:now+COLD_BACKUP_PERIODS[cadence]};
}
