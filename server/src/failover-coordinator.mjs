import {initialFailoverState,validateFailoverState,prepareFailover,setFailoverMode,renewNasLease,
  automaticFailover,publishCommit,recordReplica,observeNasRecovery,automaticFailback,replicaReady,FailoverError} from './failover-policy.mjs';

// Firestore owns the shared epoch. There is deliberately no in-memory or
// localStorage fallback for authority: two isolated authorities mean two writers.
export function createFailoverCoordinator({store,now=Date.now,authorizeAdmin,verifyCheckpoint,verifyAdapters,verifyReplica}={}) {
  if (!store || typeof store.transaction!=='function' || typeof store.read!=='function' ||
      typeof authorizeAdmin!=='function' || typeof verifyCheckpoint!=='function' ||
      typeof verifyAdapters!=='function' || typeof verifyReplica!=='function' || typeof now!=='function') throw TypeError('invalid-failover-coordinator');
  const validateTime=()=>{const time=now();if(!Number.isSafeInteger(time)||time<0)throw TypeError('invalid-coordinator-time');return time;};
  async function transact(reduce) {
    return store.transaction(async transaction=>{
      const raw=await transaction.read();
      const state=raw===null?initialFailoverState(validateTime()):validateFailoverState(raw);
      const next=await reduce(state,validateTime());
      validateFailoverState(next);
      if(next!==state)await transaction.write(next);
      return next;
    });
  }
  async function verified(checkpoint) {
    if(!await verifyCheckpoint(checkpoint))throw new FailoverError('checkpoint-not-verified');
  }
  async function verifiedReplica(provider,checkpoint) {
    if(!['synology','firebase'].includes(provider) ||
       !Number.isSafeInteger(checkpoint?.sequence) || checkpoint.sequence<0 ||
       !/^[a-f0-9]{64}$/.test(checkpoint?.hash||''))throw new FailoverError('invalid-replica-proof');
    await verified(checkpoint);
    // A Firestore checkpoint being intact does NOT prove NAS has restored it.
    // The trusted adapter must independently read back the requested provider.
    if(!await verifyReplica(provider,checkpoint))throw new FailoverError('replica-not-verified');
  }
  async function verifiedSwitchTarget(state,provider) {
    if(state.provider===provider || !state.enabled)return;
    if(!replicaReady(state,provider))throw new FailoverError('replica-not-caught-up');
    await verifiedReplica(provider,state.head);
  }
  return Object.freeze({
    read:async()=>{const raw=await store.read();return raw===null?initialFailoverState(validateTime()):validateFailoverState(raw);},
    prepare:async checkpoint=>{
      await verifiedReplica('synology',checkpoint);
      await verifiedReplica('firebase',checkpoint);
      const adapters=await verifyAdapters();
      return transact((state,time)=>prepareFailover(state,{adapters,checkpoint},time));
    },
    setMode:async(uid,mode,expectedRevision)=>transact(async(state,time)=>{
      // Authorize inside every CAS retry, including an idempotent mode request.
      // Revoked permission must not survive a stale browser tab or retry.
      const actor=await authorizeAdmin(uid);
      if(actor?.role==='admin' && actor.status==='active' && !actor.deleted &&
         state.enabled && mode!=='auto' && state.provider!==mode && expectedRevision===state.revision)
        await verifiedSwitchTarget(state,mode);
      return setFailoverMode(state,mode,{actor,expectedRevision},time);
    }),
    renew:proof=>transact((state,time)=>renewNasLease(state,proof,time)),
    takeover:input=>transact(async(state,time)=>{
      const next=automaticFailover(state,input,time);
      if(next.provider!==state.provider)await verifiedSwitchTarget(state,next.provider);
      return next;
    }),
    publish:async(proof,checkpoint)=>{
      await verifiedReplica(proof?.provider,checkpoint);
      return transact((state,time)=>publishCommit(state,proof,checkpoint,time));
    },
    caughtUp:async(provider,checkpoint)=>{
      await verifiedReplica(provider,checkpoint);
      return transact((state,time)=>recordReplica(state,provider,checkpoint,time));
    },
    observeRecovery:healthy=>transact((state,time)=>observeNasRecovery(state,healthy,time)),
    failback:()=>transact(async(state,time)=>{
      const next=automaticFailback(state,time);
      if(next.provider!==state.provider)await verifiedSwitchTarget(state,next.provider);
      return next;
    }),
  });
}

export function firestoreAuthorityStore(firestore) {
  if (firestore?.projectId!=='samosval-offline' || typeof firestore.runTransaction!=='function')
    throw TypeError('test-firestore-required');
  const ref=firestore.doc('test_failover/main_workspace');
  const value=snapshot=>snapshot.exists?snapshot.data():null;
  return Object.freeze({
    read:async()=>value(await ref.get()),
    transaction:fn=>firestore.runTransaction(tx=>fn({read:async()=>value(await tx.get(ref)),write:state=>tx.set(ref,state)})),
  });
}
