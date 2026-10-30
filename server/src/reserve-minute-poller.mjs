// TEST 4.1 — scheduling coordinator for the existing minute replica runner.
// Dependency-injected and INACTIVE until the transactional PostgreSQL outbox,
// durable CAS receipts and privileged Firebase service are installed and proven.
// Never infer a successful write from elapsed time or an HTTP success alone.
import {MINUTE_REPLICA_MS} from './reserve-minute-replication.mjs';
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const validHead=x=>x&&Number.isSafeInteger(x.sequence)&&x.sequence>=0&&digest(x.hash);
const equalHead=(a,b)=>a.sequence===b.sequence&&a.hash===b.hash;
export function createMinuteReservePoller({runner,readReceipt,now=Date.now,maxBatches=10}={}){
  if(typeof runner?.tick!=='function'||typeof readReceipt!=='function'||
    typeof now!=='function'||!Number.isSafeInteger(maxBatches)||maxBatches<1||maxBatches>100)
    throw TypeError('invalid-minute-poller');
  let busy=false,lastAttemptAt=null;
  return Object.freeze({
    get busy(){return busy;},
    get lastAttemptAt(){return lastAttemptAt;},
    async poll({force=false}={}){
      if(busy)return {status:'busy',writes:0};
      const startedAt=now();
      if(!Number.isSafeInteger(startedAt)||startedAt<0)throw TypeError('invalid-minute-clock');
      if(force!==true&&lastAttemptAt!==null&&startedAt-lastAttemptAt<MINUTE_REPLICA_MS)
        return {status:'not-due',writes:0,nextDueAt:lastAttemptAt+MINUTE_REPLICA_MS};
      busy=true;
      try{
        let head=await readReceipt();
        if(!validHead(head))throw Error('invalid-durable-replica-receipt');
        let writes=0,events=0,morePending=false;
        do{
          const outcome=await runner.tick({previous:head,force:true});
          if(outcome?.status==='unchanged'){
            morePending=false;break;
          }
          if(outcome?.status!=='replicated'||!validHead(outcome.receipt)||
            !Number.isSafeInteger(outcome.events)||outcome.events<1||
            outcome.writes!==1||outcome.receipt.sequence<=head.sequence)
            throw Error('invalid-minute-replica-result');
          // Do not trust an in-memory response. Confirm the durable NAS CAS
          // receipt before advancing the cursor or sending another packet.
          const durable=await readReceipt();
          if(!validHead(durable)||!equalHead(durable,outcome.receipt))
            throw Error('minute-durable-receipt-mismatch');
          head=durable;
          writes++;
          events+=outcome.events;
          morePending=outcome.morePending===true;
        }while(morePending&&writes<maxBatches);
        lastAttemptAt=startedAt;
        return {status:writes?(morePending?'backlog-remains':'replicated'):'unchanged',
          writes,events,morePending,lastAttemptAt,receipt:head};
      }finally{busy=false;}
    }
  });
}
