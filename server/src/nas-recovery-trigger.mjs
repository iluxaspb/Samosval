// TEST 4.1 recovery trigger: start restoring NAS as soon as it becomes healthy.
// Restoration is separate from authorizing NAS to resume accepting writes.
// The injected replay adapter must write into a fenced RESTORE path; never
// open a second business writer while Firebase remains authoritative.
const sameHead=(a,b)=>a?.sequence===b?.sequence&&a?.hash===b?.hash;
const ready=s=>s?.format==='samosval-test-failover'&&s.projectId==='samosval-offline'&&
  s.workspaceId==='main_workspace'&&s.enabled===true&&s.provider==='firebase'&&
  Number.isSafeInteger(s.epoch)&&s.epoch>0&&Number.isSafeInteger(s.head?.sequence)&&
  /^[a-f0-9]{64}$/.test(s.head?.hash||'');
export function createImmediateNasRecovery({readAuthority,replayFirebaseChanges,verifyNasReplica}={}){
  if(![readAuthority,replayFirebaseChanges,verifyNasReplica].every(x=>typeof x==='function'))
    throw TypeError('invalid-nas-recovery-trigger');
  let busy=false;
  return Object.freeze({
    get busy(){return busy;},
    async onReady({nasHealthy=false}={}){
      if(!nasHealthy)return {status:'nas-unavailable',switchBack:false};
      if(busy)return {status:'recovery-already-running',switchBack:false};
      busy=true;
      try{
        const before=await readAuthority();
        if(!ready(before))return {status:'firebase-not-authoritative',switchBack:false};
        const target={...before.head},epoch=before.epoch;
        // Begin immediately on a successful NAS readiness signal.
        // The adapter handles idempotent receipts and all data domains.
        await replayFirebaseChanges({target,epoch,workspaceId:'main_workspace',allowBusinessWrites:false});
        // Firebase can still receive operations during replay; never certify a
        // stale NAS if the epoch or current head advanced meanwhile.
        const after=await readAuthority();
        if(!ready(after)||after.epoch!==epoch||!sameHead(after.head,target))
          return {status:'firebase-head-advanced',switchBack:false};
        if(!await verifyNasReplica(target))
          return {status:'nas-restore-not-verified',switchBack:false};
        return {status:'nas-restored-candidate',target,epoch,switchBack:false,
          next:'verify-receipts-and-claim-caught-up-via-shared-authority-CAS'};
      }finally{busy=false;}
    }
  });
}
