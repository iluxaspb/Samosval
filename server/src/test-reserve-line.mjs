// TEST Firebase business adapter for LINE operations only.
// It consumes server-owned PostgreSQL mirror rows, never legacy Firestore docs.
// This module is not a deployable whole-application failover endpoint.
import {createHash} from 'node:crypto';
import {applyLineOperation,validateLineOperation} from './line-rules.mjs';
import {rewardSnapshot} from './game-economy.mjs';
import {REPLICA_DOC,rowId,canonical,sha256,assertTestProject} from './test-replica.mjs';
import {OWNER_DOC,OWNER_LEASE_MS} from './test-writer-coordinator.mjs';

const FIELDS=['id','type','truckId','shiftId','createdAt','expectedRevision',
 'expectedTtnRevision','arrivalTimestamp','lastLoadTimestamp','wantArrived',
 'collect','cycleMinutes','logId'];
const ACTIONS={arrive:'action_arrive',load:'action_load',ttn:'action_ttn',reset:'admin_only'};
const bad=(code,status=409)=>Object.assign(new Error(code),{code,status});
const validId=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(s);
const pad=n=>String(n).padStart(20,'0');
const doc=(db,generation,table,key)=>db.doc(REPLICA_DOC+'/rows_'+generation+'/'+rowId(table,key));
const opRef=(db,generation,seq)=>db.doc(REPLICA_DOC+'/reserve_ops_'+generation+'/'+pad(seq));
const parse=s=>{try{return JSON.parse(s);}catch{throw bad('reserve-row-invalid');}};
function decode(snapshot,table,key){
 if(!snapshot?.exists)return null;
 const d=snapshot.data();
 if(d?.table!==table||d?.keyJson!==canonical(key)||typeof d.rowJson!=='string')
  throw bad('reserve-row-invalid');
 return parse(d.rowJson);
}
function checkedOwner(owner,meta,expectedEpoch,now){
 if(meta?.protocol!==1||meta.channel!=='test'||meta.projectId!=='samosval-offline'||
    !meta.readyForFailover||typeof meta.generation!=='string'||!meta.generation||
    !/^[0-9a-f]{64}$/.test(meta.hash||''))
  throw bad('reserve-generation-not-ready',503);
 if(owner?.protocol!==1||owner.projectId!=='samosval-offline'||
    owner.owner!=='firebase'||owner.holder!=='firebase_reserve'||
    !Number.isSafeInteger(owner.epoch)||owner.epoch!==expectedEpoch||
    owner.generation!==meta.generation||
    !Number.isSafeInteger(owner.leaseUntil)||owner.leaseUntil<=0)
  throw bad('reserve-not-write-owner',503);
 if(owner.observedSequence!==meta.lastSequence)throw bad('reserve-base-checkpoint-changed',503);
 return owner;
}
function envelope(table,key,row,baseSeq,reserveSeq){
 return {table,keyJson:canonical(key),rowJson:canonical(row),
  appliedSequence:baseSeq,reserveSequence:reserveSeq};
}
function lineKey(ws,id){return {workspace_id:ws,truck_id:id};}
function auditRow(ws,op,uid,at){
 return {workspace_id:ws,operation_id:op.id,uid,type:op.type,status:'confirmed',created_at:new Date(at).toISOString()};
}
/**
 * Called only by a trusted service after Firebase Auth JWT verification.
 * Exactly one Firestore transaction owns the status, receipt, operation ledger,
 * and writer epoch. A replay is checked against uid, request hash and role.
 *
 * Errors are deliberately fail-closed; retries keep op.id unchanged.
 */
export async function reserveLineOperation({firestore,projectId,uid,workspaceId='main_workspace',
 input,expectedEpoch,now=Date.now()}={}){
 assertTestProject(projectId);
 if(!validId(uid)||!validId(workspaceId)||!Number.isSafeInteger(expectedEpoch)||
    expectedEpoch<1||!Number.isSafeInteger(now)||now<=0)
  throw bad('reserve-invalid-context',400);
 const error=validateLineOperation(input,now);
 if(error)throw bad(error,400);
 const op=Object.fromEntries(FIELDS.filter(k=>input[k]!==undefined).map(k=>[k,input[k]]));
 const requestHash=createHash('sha256').update(JSON.stringify(op)).digest('hex');
 const metaRef=firestore.doc(REPLICA_DOC),ownerRef=firestore.doc(OWNER_DOC);
 return firestore.runTransaction(async tx=>{
  // All Firestore transaction reads precede all writes.
  const [metaSnap,ownerSnap]=await Promise.all([tx.get(metaRef),tx.get(ownerRef)]);
  const meta=metaSnap.exists?metaSnap.data():null;
  const owner=checkedOwner(ownerSnap.exists?ownerSnap.data():null,meta,expectedEpoch,now);
  const generation=meta.generation,ws=workspaceId;
  const refs={
   user:doc(firestore,generation,'app_users',{uid}),
   permission:doc(firestore,generation,'role_permissions',{role:'',action:''}),
   workspace:doc(firestore,generation,'workspaces',{id:ws}),
   shift:doc(firestore,generation,'shifts',{workspace_id:ws,shift_id:op.shiftId}),
   truck:doc(firestore,generation,'line_trucks',lineKey(ws,op.truckId)),
   status:doc(firestore,generation,'line_truck_statuses',lineKey(ws,op.truckId)),
   receipt:doc(firestore,generation,'line_operation_receipts',{workspace_id:ws,operation_id:op.id}),
   log:doc(firestore,generation,'line_logs',{workspace_id:ws,log_id:
    'load_'+op.truckId+'_'+op.shiftId+'_cycle_'+op.expectedRevision+'_'+Number(op.arrivalTimestamp||0)}),
   history:doc(firestore,generation,'line_history',{workspace_id:ws,action_id:op.id}),
   audit:doc(firestore,generation,'line_audit',{workspace_id:ws,operation_id:op.id}),
   settings:doc(firestore,generation,'workspace_settings',{workspace_id:ws})
  };
  // Permissions use the server-mirrored role, never a client-supplied role.
  const user=decode(await tx.get(refs.user),'app_users',{uid});
  if(!user||user.status!=='active'||user.profile?.deleted)throw bad('forbidden',403);
  const isAdmin=user.role==='admin';
  if(op.type==='reset'&&!isAdmin)throw bad('forbidden',403);
  const permKey={role:user.role,action:ACTIONS[op.type]};
  const permRef=doc(firestore,generation,'role_permissions',permKey);
  const [permSnap,workspaceSnap,shiftSnap,truckSnap,statusSnap,receiptSnap,
   logSnap,historySnap,auditSnap,settingsSnap]=await Promise.all([
    tx.get(permRef),tx.get(refs.workspace),tx.get(refs.shift),tx.get(refs.truck),
    tx.get(refs.status),tx.get(refs.receipt),tx.get(refs.log),tx.get(refs.history),
    tx.get(refs.audit),tx.get(refs.settings)
   ]);
  if(!isAdmin&&!decode(permSnap,'role_permissions',permKey)?.allowed)
   throw bad('forbidden',403);
  const receiptKey={workspace_id:ws,operation_id:op.id};
  const existing=decode(receiptSnap,'line_operation_receipts',receiptKey);
  if(existing){
   if(existing.uid!==uid||existing.request_hash!==requestHash)
    throw bad('operation-id-reused',409);
   return {...existing.result,replayed:true};
  }
  if(historySnap.exists||auditSnap.exists)throw bad('reserve-operation-history-conflict');
  const workspace=decode(workspaceSnap,'workspaces',{id:ws});
  const shift=decode(shiftSnap,'shifts',{workspace_id:ws,shift_id:op.shiftId});
  const truck=decode(truckSnap,'line_trucks',lineKey(ws,op.truckId));
  const status=decode(statusSnap,'line_truck_statuses',lineKey(ws,op.truckId));
  const policy=decode(settingsSnap,'workspace_settings',{workspace_id:ws})?.payload||{};
  if(!workspace)throw bad('workspace-not-ready');
  const before=status?.payload||{};
  let result;
  if(!shift?.is_active||shift.payload?.closing)
   result={outcome:'rejected',reason:'shift-changed',status:before};
  else if(!status||!truck||truck.payload?.deleted||!before.onLine||before.shiftId!==op.shiftId)
   result={outcome:'rejected',reason:'truck-not-on-line',status:before};
  else result=applyLineOperation({op,before,truck:truck.payload,
   actor:{name:user.display_name,email:user.email,isAdmin},
   cycleMinutes:workspace.cycle_minutes||15,now});
  if(result.outcome==='confirmed'&&result.log&&logSnap.exists)
   result={outcome:'rejected',reason:'duplicate',status:before};
  const saved={outcome:result.outcome,reason:result.reason||null,
   status:result.status||null,log:result.log||null};
  const seq=(Number(owner.reserveSequence)||0)+1;
  if(!Number.isSafeInteger(seq)||seq<1)throw bad('reserve-sequence-overflow');
  const initialHash=sha256('reserve:'+meta.hash+':'+expectedEpoch);
  const previousHash=owner.reserveHash||initialHash;
  if(!/^[a-f0-9]{64}$/.test(previousHash))throw bad('reserve-checkpoint-invalid');
  const ledger={sequence:seq,epoch:expectedEpoch,uid,workspaceId:ws,
   op,requestHash,result:saved,at:now,previousHash};
  const hash=sha256(previousHash+'\n'+canonical(ledger));
  const next={...ledger,hash};
  tx.create(opRef(firestore,generation,seq),next);
  tx.create(refs.receipt,envelope('line_operation_receipts',receiptKey,{
   ...receiptKey,uid,request_hash:requestHash,result:saved,
   recorded_at:new Date(now).toISOString()},meta.lastSequence,seq));
  if(result.outcome==='confirmed'){
   const statusRow={workspace_id:ws,truck_id:op.truckId,shift_id:op.shiftId,payload:result.status};
   tx.set(refs.status,envelope('line_truck_statuses',lineKey(ws,op.truckId),
    statusRow,meta.lastSequence,seq));
   if(result.log){
    const logKey={workspace_id:ws,log_id:result.log.id};
    tx.create(refs.log,envelope('line_logs',logKey,{...logKey,
     shift_id:op.shiftId,truck_id:op.truckId,payload:result.log},meta.lastSequence,seq));
   }
   const historyKey={workspace_id:ws,action_id:op.id};
   const shiftInfo=shift.payload||{};
   const rewards=rewardSnapshot(policy,{id:op.id,type:op.type,at:op.createdAt},now);
   const history={...historyKey,uid,shift_id:op.shiftId,truck_id:op.truckId,
    type:op.type,before_status:before,after_status:result.status,
    log_data:result.log||null,game_rewards:rewards,
    game_actor:{email:user.email||'',name:user.display_name||'',
     objectId:shiftInfo.objectId||'',objectName:shiftInfo.objectName||''},
    undone:false,revision:1,created_at:new Date(now).toISOString()};
   tx.create(refs.history,envelope('line_history',historyKey,history,meta.lastSequence,seq));
   const auditKey={workspace_id:ws,operation_id:op.id};
   tx.create(refs.audit,envelope('line_audit',auditKey,auditRow(ws,op,uid,now),
    meta.lastSequence,seq));
  }
  tx.update(ownerRef,{reserveSequence:seq,reserveHash:hash,
   lastWriteAt:now,leaseUntil:now+OWNER_LEASE_MS,updatedAt:now});
  return saved;
 });
}
