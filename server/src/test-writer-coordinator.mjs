// TEST-only coordination protocol. Firebase is the serialization authority.
// No browser can create permits. Promotion is unavailable until a separately
// verified Firebase business adapter marks the mirror ready for failover.
import {randomUUID} from 'node:crypto';
import {assertTestProject,REPLICA_DOC} from './test-replica.mjs';

export const OWNER_DOC='samosval_test_replica/write_owner';
export const OWNER_LEASE_MS=60000;
export const OPERATION_HOLD_MS=15000;
export const FENCE_GRACE_MS=30000;
const HASH=/^[0-9a-f]{64}$/;
const positive=x=>Number.isSafeInteger(x)&&x>0;
const invalid=code=>Object.assign(new Error(code),{code});
const snapData=s=>s?.exists?s.data():null;
const validId=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{8,160}$/.test(x);
function mirrorMetadata(m){
 if(!m||m.protocol!==1||m.channel!=='test'||m.writer!=='synology'||
    m.projectId!=='samosval-offline'||typeof m.generation!=='string'||
    !m.generation||!Number.isSafeInteger(m.lastSequence)||m.lastSequence<0||
    !HASH.test(m.hash||'')||typeof m.readyForFailover!=='boolean')
   throw invalid('writer-mirror-checkpoint-invalid');
 return m;
}
function ownerState(value){
 if(!value||value.protocol!==1||value.projectId!=='samosval-offline'||
    !['synology','firebase','reconciling','handoff'].includes(value.owner)||!positive(value.epoch)||
    !validId(value.holder)||!positive(value.leaseUntil)||
    typeof value.generation!=='string'||!Number.isSafeInteger(value.observedSequence)||
    value.observedSequence<0||!value.pending||
    typeof value.pending!=='object'||Array.isArray(value.pending))
   throw invalid('writer-ownership-invalid');
 for(const [id,ticket] of Object.entries(value.pending)){
  if(!validId(id)||!ticket||!positive(ticket.until)||ticket.epoch!==value.epoch)
   throw invalid('writer-pending-permit-invalid');
 }
 return value;
}
function stillPending(state,_now){
 // A timeout cannot prove a PostgreSQL commit has stopped. Even an expired
 // permit may correspond to an in-flight NAS transaction. Never promote or
 // transfer ownership until all server-side write intents are explicitly
 // acknowledged by the original owner or reconciled against PostgreSQL.
 return Object.keys(state.pending).length>0;
}
function requireCheckpoint(m,checkpoint){
 if(!checkpoint||checkpoint.sequence!==m.lastSequence||checkpoint.hash!==m.hash)
  throw invalid('writer-mirror-not-confirmed-locally');
}
export function assertCoordinatorProject(projectId){assertTestProject(projectId);}
export async function claimNasOwnership({firestore,projectId,nodeId,checkpoint,now=Date.now()}){
 assertCoordinatorProject(projectId);
 if(!validId(nodeId)||!Number.isSafeInteger(now)||now<1)throw invalid('writer-invalid-node');
 const metaRef=firestore.doc(REPLICA_DOC),ownerRef=firestore.doc(OWNER_DOC);
 return firestore.runTransaction(async tx=>{
  // Firestore requires all transaction reads before any writes.
  const [metaSnap,ownerSnap]=await Promise.all([tx.get(metaRef),tx.get(ownerRef)]);
  const m=mirrorMetadata(snapData(metaSnap));requireCheckpoint(m,checkpoint);
  const current=snapData(ownerSnap);
  if(!current){
   const created={protocol:1,projectId:'samosval-offline',owner:'synology',
    holder:nodeId,epoch:1,leaseUntil:now+OWNER_LEASE_MS,
    generation:m.generation,observedSequence:m.lastSequence,pending:{},updatedAt:now};
   tx.create(ownerRef,created);
   return {epoch:created.epoch,leaseUntil:created.leaseUntil,created:true};
  }
  const state=ownerState(current);
  if(state.owner!=='synology'||state.generation!==m.generation)
   throw invalid('writer-owner-not-synology');
  if(state.holder===nodeId&&state.leaseUntil>now){
   if(state.leaseUntil<now+OPERATION_HOLD_MS)
    throw invalid('writer-lease-almost-expired');
   const leaseUntil=now+OWNER_LEASE_MS;
   tx.update(ownerRef,{leaseUntil,observedSequence:m.lastSequence,updatedAt:now});
   return {epoch:state.epoch,leaseUntil,created:false};
  }
  if(state.leaseUntil+FENCE_GRACE_MS>=now)
   throw invalid('writer-lease-held-by-another-process');
  if(stillPending(state,now))throw invalid('writer-pending-operations');
  // A prior process may resume after takeover. Its old epoch and node ID no
  // longer authorize even a single write permit.
  const epoch=state.epoch+1,leaseUntil=now+OWNER_LEASE_MS;
  tx.update(ownerRef,{holder:nodeId,epoch,leaseUntil,pending:{},
   observedSequence:m.lastSequence,updatedAt:now});
  return {epoch,leaseUntil,created:false,reclaimed:true};
 });
}
export async function acquireNasWritePermit({firestore,projectId,nodeId,now=Date.now(),permitId=randomUUID()}){
 assertCoordinatorProject(projectId);
 if(!validId(nodeId)||!validId(permitId)||!Number.isSafeInteger(now)||now<1)
  throw invalid('writer-invalid-permit');
 const ref=firestore.doc(OWNER_DOC);
 return firestore.runTransaction(async tx=>{
  const state=ownerState(snapData(await tx.get(ref)));
  if(state.owner!=='synology'||state.holder!==nodeId||state.leaseUntil<=now+OPERATION_HOLD_MS)
   throw invalid('writer-synology-not-authorized');
  if(Object.hasOwn(state.pending,permitId))throw invalid('writer-permit-reused');
  if(Object.keys(state.pending).length>=64)throw invalid('writer-too-many-in-flight');
  const ticket={epoch:state.epoch,until:now+OPERATION_HOLD_MS};
  tx.update(ref,{pending:{...state.pending,[permitId]:ticket},updatedAt:now});
  return {permitId,epoch:state.epoch,until:ticket.until};
 });
}
export async function releaseNasWritePermit({firestore,projectId,nodeId,permit}){
 assertCoordinatorProject(projectId);
 if(!validId(nodeId)||!permit||!validId(permit.permitId)||!positive(permit.epoch))
  throw invalid('writer-invalid-permit');
 const ref=firestore.doc(OWNER_DOC);
 return firestore.runTransaction(async tx=>{
  const state=ownerState(snapData(await tx.get(ref)));
  // A stale process may not mutate the current epoch's permits.
  if(state.owner!=='synology'||state.holder!==nodeId||state.epoch!==permit.epoch)
   return false;
  if(!Object.hasOwn(state.pending,permit.permitId))return false;
  const pending={...state.pending};
  delete pending[permit.permitId];
  tx.update(ref,{pending,updatedAt:Date.now()});
  return true;
 });
}
// This transfer primitive is only for integration testing until the real
// reserve business writer, bidirectional receipts and fencing are verified.
// Current mirror metadata explicitly sets readyForFailover=false.
export async function promoteTestReserve({firestore,projectId,expectedEpoch,now=Date.now()}){
 assertCoordinatorProject(projectId);
 if(!positive(expectedEpoch)||!Number.isSafeInteger(now)||now<1)
  throw invalid('writer-invalid-promotion');
 const metaRef=firestore.doc(REPLICA_DOC),ownerRef=firestore.doc(OWNER_DOC);
 return firestore.runTransaction(async tx=>{
  const [metaSnap,ownerSnap]=await Promise.all([tx.get(metaRef),tx.get(ownerRef)]);
  const m=mirrorMetadata(snapData(metaSnap)),state=ownerState(snapData(ownerSnap));
  if(state.owner!=='synology'||state.epoch!==expectedEpoch)
   throw invalid('writer-promotion-epoch-changed');
  if(m.readyForFailover!==true||state.generation!==m.generation||
     m.lastSequence<state.observedSequence)
   throw invalid('writer-reserve-not-ready');
  if(state.leaseUntil+FENCE_GRACE_MS>=now||stillPending(state,now))
   throw invalid('writer-promotion-wait-for-nas');
  const epoch=state.epoch+1;
  tx.update(ownerRef,{owner:'firebase',holder:'firebase_reserve',epoch,
   leaseUntil:now+OWNER_LEASE_MS,pending:{},observedSequence:m.lastSequence,updatedAt:now});
  return {owner:'firebase',epoch,recoveryPoint:m.lastSequence};
 });
}
export async function readWriteOwnership({firestore,projectId}){
 assertCoordinatorProject(projectId);
 const snap=await firestore.doc(OWNER_DOC).get();
 const state=snapData(snap);
 if(!state)return {configured:false,owner:null,epoch:null,leaseUntil:null,pending:0};
 const valid=ownerState(state);
 return {configured:true,owner:valid.owner,epoch:valid.epoch,leaseUntil:valid.leaseUntil,
  pending:Object.keys(valid.pending).length,observedSequence:valid.observedSequence};
}
