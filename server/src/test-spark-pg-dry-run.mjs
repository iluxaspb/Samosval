// TEST-only deterministic plan for frozen Spark→PostgreSQL handback.
// No SQL writes. The production replay worker must recheck the same base
// checkpoint under a write fence before executing any of these operations.
import {createHash} from 'node:crypto';
import {applyLineOperation,validateLineOperation} from './line-rules.mjs';
import {canonical} from './test-replica.mjs';

const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const seq=x=>Number.isSafeInteger(x)&&x>=0;
const fail=code=>Object.assign(new Error(code),{code});
const sha=x=>createHash('sha256').update(canonical(x)).digest('hex');
const own=(data,key)=>Object.prototype.hasOwnProperty.call(data,key);

export function planSparkPostgresReplay({manifest,baseline,apply=applyLineOperation}={}){
 if(!manifest||manifest.format!=='spark-typed-replay-manifest'||manifest.version!==1||
    !Array.isArray(manifest.events)||manifest.eventCount!==manifest.events.length||
    manifest.eventCount>10000||manifest.ownerEpoch!==manifest.fromEpoch+1||
    !/^[0-9a-f]{64}$/.test(manifest.sha256||'')||!baseline||
    baseline.sequence!==manifest.baseSequence||baseline.hash!==manifest.baseHash||
    !obj(baseline.statuses)||!obj(baseline.trucks)||!obj(baseline.actors)||
    typeof apply!=='function'||!Number.isSafeInteger(baseline.cycleMinutes)||
    baseline.cycleMinutes<15||baseline.cycleMinutes>10080||
    typeof baseline.shiftId!=='string'||!baseline.shiftId||
    baseline.shiftActive!==true)
  throw fail('spark-replay-pg-baseline-not-matched');
 const expected=sha(manifest.events.map(({at,...e})=>e));
 if(manifest.sha256!==expected)throw fail('spark-replay-plan-hash-diverged');
 const working=new Map(),planned=[];
 for(const [key,row] of Object.entries(baseline.statuses)){
  if(!obj(row))throw fail('spark-replay-pg-status-invalid');
  working.set(key,{...row});
 }
 let lastAt=0;
 for(const event of manifest.events){
  if(!obj(event)||!seq(event.serverAt)||event.serverAt<=0||
     event.serverAt<lastAt||event.shiftId!==baseline.shiftId)
   throw fail('spark-replay-plan-order-diverged');
  lastAt=event.serverAt;
  const actor=baseline.actors[event.uid];
  const action='action_'+event.type;
  if(!obj(actor)||actor.status!=='active'||!Array.isArray(actor.actions)||
     !actor.actions.includes(action))
   throw fail('spark-replay-actor-not-authorized');
  const truck=baseline.trucks[event.truckId],before=working.get(event.truckId);
  if(!obj(truck)||!obj(before)||before.shiftId!==baseline.shiftId||
     before.onLine!==true)
   throw fail('spark-replay-pg-truck-invalid');
  // Firestore Security Rules stamp event.at from request.time. Replay based
  // on that verified instant rather than a phone clock which may have drifted.
  const op={...event.intent,
   // Spark's minimal intent may omit fields required by the NAS API.
   // Keep originalRequestHash intact, but normalize the PG receipt payload.
   expectedTtnRevision:event.intent.expectedTtnRevision??0,
   wantArrived:event.intent.wantArrived??false,
   collect:event.intent.collect??false,
   createdAt:event.serverAt};
  delete op.logId; // PostgreSQL derives deterministic log IDs from the cycle.
  if(validateLineOperation(op,event.serverAt))
   throw fail('spark-replay-pg-intent-invalid');
  const oldStatus=structuredClone(before);
  const result=apply({op,before,truck,
   actor:{name:actor.name,email:actor.email,isAdmin:actor.role==='admin'},
   cycleMinutes:baseline.cycleMinutes,now:event.serverAt});
  if(result.outcome!=='confirmed'||!obj(result.status)||
     result.status.cycleRevision!==event.revision||
     (event.type==='ttn'&&result.status.ttnRevision!==event.ttnRevision)||
     (event.type==='load'&&(!result.log||
       result.log.volume!==event.volume||
       Boolean(result.log.isGAI)!==event.isGAI)))
   throw fail('spark-replay-pg-business-diverged');
  working.set(event.truckId,result.status);
  planned.push({operationId:event.operationId,uid:event.uid,
   serverAt:event.serverAt,originalRequestHash:event.requestHash,
   pgIntent:op,pgReceipt:result,beforeStatus:oldStatus,
   actor:{name:actor.name,email:actor.email,role:actor.role},
   truck:structuredClone(truck),cycleMinutes:baseline.cycleMinutes,
   ...(event.type==='load'?{
    reserveLogId:event.logId,postgresLogId:result.log.id
   }:{})});
 }
 return Object.freeze({
  format:'spark-typed-pg-dry-run',version:1,
  generation:manifest.generation,fromEpoch:manifest.fromEpoch,
  baseSequence:manifest.baseSequence,baseHash:manifest.baseHash,
  eventCount:planned.length,
  plannedHash:sha(planned),
  operations:planned,
  expectedStatuses:Object.fromEntries(working)
 });
}
