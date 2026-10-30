// TEST 4.1 policy/adapter: immutable minute batches from a durable NAS mutation outbox.
// Does not install a timer, discover SQL changes, or enable Firebase business writes.
// Every INSERT/UPDATE/DELETE must first enter a TRANSACTIONAL PostgreSQL outbox.
import {createHash} from 'node:crypto';
import {canonicalReserve,RESERVE_TABLES} from './reserve-checkpoint.mjs';
export const MINUTE_REPLICA_MS=60_000;
export const MAX_REPLICA_BATCH_BYTES=700_000; // Firestore document <= 1 MiB; leave overhead.
export const MAX_REPLICA_EVENTS=500;
const hash=x=>createHash('sha256').update(x).digest('hex');
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const id=x=>typeof x==='string'&&x.length>0&&x.length<=160;
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const tableSet=new Set(RESERVE_TABLES);
function invalid(code){throw Error(code);}
export function buildMinuteReserveBatch({previous,events,maxBytes=MAX_REPLICA_BATCH_BYTES}={}){
  if(!previous||!integer(previous.sequence)||!digest(previous.hash)||
     !Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>MAX_REPLICA_BATCH_BYTES||
     !Array.isArray(events)||!events.length||events.length>MAX_REPLICA_EVENTS)
    invalid('invalid-minute-batch');
  const ids=new Set();
  for(let i=0;i<events.length;i++){
    const e=events[i];
    if(!e||!integer(e.sequence)||e.sequence!==previous.sequence+i+1||
       !id(e.operationId)||!id(e.rowId)||!tableSet.has(e.table)||
       !['upsert','delete'].includes(e.action)||
       e.projectId!=='samosval-offline'||e.workspaceId!=='main_workspace'||
       (e.action==='upsert'&&(!e.row||typeof e.row!=='object'||Array.isArray(e.row)))||
       (e.action==='delete'&&e.row!==null)||ids.has(e.sequence))
      invalid('invalid-minute-event');
    ids.add(e.sequence);
    // Reject unsupported values (NaN, Dates, undefined) before persistence.
    try{canonicalReserve(e);}catch{invalid('invalid-minute-event');}
  }
  const payload={format:'samosval-minute-reserve',version:1,projectId:'samosval-offline',
    workspaceId:'main_workspace',previous,
    from:events[0].sequence,to:events.at(-1).sequence,events};
  const body=canonicalReserve(payload),bytes=Buffer.byteLength(body,'utf8');
  if(bytes>maxBytes)invalid('minute-batch-too-large');
  const batchId=hash(body);
  return {batchId,bytes,document:{...payload,batchId}};
}
export function verifyMinuteReserveBatch(batch){
  try{
    if(!batch||!digest(batch.batchId)||!integer(batch.bytes)||!batch.document||
       batch.document.batchId!==batch.batchId)return false;
    const {batchId,...rest}=batch.document;
    return buildMinuteReserveBatch({previous:rest.previous,events:rest.events}).batchId===batchId&&
      Buffer.byteLength(canonicalReserve(rest),'utf8')===batch.bytes&&
      rest.from===rest.previous.sequence+1&&rest.to===rest.events.at(-1).sequence;
  }catch{return false;}
}
// Choose the largest contiguous prefix that fits one Firestore document.
// The remaining committed rows are kept pending and sent in following batches.
export function selectMinuteReserveBatch({previous,events,maxBytes=MAX_REPLICA_BATCH_BYTES}={}){
  if(!Array.isArray(events)||events.length===0)throw Error('invalid-minute-events');
  const eligible=events.slice(0,MAX_REPLICA_EVENTS);
  // Validate event continuity before shrinking for document size, so a gap
  // cannot be disguised by silently taking only an earlier prefix.
  buildMinuteReserveBatch({previous,events:eligible,maxBytes:MAX_REPLICA_BATCH_BYTES});
  let low=1,high=eligible.length,best=null;
  while(low<=high){
    const middle=Math.floor((low+high)/2);
    try{
      const candidate=buildMinuteReserveBatch({previous,events:eligible.slice(0,middle),maxBytes});
      best=candidate;low=middle+1;
    }catch(error){
      if(error?.message!=='minute-batch-too-large')throw error;
      high=middle-1;
    }
  }
  if(!best)throw Error('minute-event-exceeds-document-size');
  return {...best,morePending:events.length>best.document.events.length};
}
// readPending must only return COMMITTED, sequence-contiguous outbox rows.
// persistReceipt is a durable NAS write, done only after Firebase readback.
// For a failed upload/readback we NEVER advance the checkpoint; the same ID retries.
export function createMinuteReplicaRunner({readPending,putImmutable,readBack,persistReceipt,now=Date.now}={}){
  if(![readPending,putImmutable,readBack,persistReceipt,now].every(x=>typeof x==='function'))
    throw TypeError('invalid-minute-replica-runner');
  let busy=false;
  return Object.freeze({
    get busy(){return busy;},
    async tick({previous,lastAttemptAt=null,force=false}={}){
      if(busy)return {status:'busy'};
      const time=now();
      if(!integer(time)||lastAttemptAt!==null&&(!integer(lastAttemptAt)||lastAttemptAt>time))
        throw TypeError('invalid-minute-clock');
      if(force!==true&&lastAttemptAt!==null&&time-lastAttemptAt<MINUTE_REPLICA_MS)return {status:'not-due',nextDueAt:lastAttemptAt+MINUTE_REPLICA_MS};
      if(!previous||!integer(previous.sequence)||!digest(previous.hash))throw TypeError('invalid-minute-replica-head');
      busy=true;
      try{
        const events=await readPending(previous.sequence,MAX_REPLICA_EVENTS+1);
        if(!Array.isArray(events))invalid('invalid-minute-events');
        if(!events.length)return {status:'unchanged',lastAttemptAt:time,writes:0};
        const batch=selectMinuteReserveBatch({previous,events});
        await putImmutable(batch); // create-only; hash ID makes retries idempotent
        const saved=await readBack(batch.batchId);
        if(!saved||canonicalReserve(saved)!==canonicalReserve(batch.document))
          invalid('minute-batch-readback-mismatch');
        const receipt={sequence:batch.document.to,hash:batch.batchId};
        await persistReceipt({receipt,previous,batchId:batch.batchId}); // CAS in production
        return {status:'replicated',receipt,lastAttemptAt:time,writes:1,events:batch.document.events.length,morePending:batch.morePending};
      }finally{busy=false;}
    }
  });
}
