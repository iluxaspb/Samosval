// TEST single-writer protocol. Network probes never grant write authority.
// `now` is supplied by the trusted coordinator, never by a browser timestamp.
export const FAILOVER_FORMAT = 'samosval-test-failover';
export const MODES = Object.freeze(['auto', 'synology', 'firebase']);
export const LEASE_MS = 30000;
export const RECOVERY_MS = 60000;
export class FailoverError extends Error {
  constructor(code, status=409) { super(code); this.name='FailoverError'; this.code=code; this.status=status; }
}
const fail = code => { throw new FailoverError(code); };
const integer = x => Number.isSafeInteger(x) && x >= 0;
const digest = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function clock(now) { if (!integer(now)) throw new TypeError('invalid-coordinator-time'); }
function admin(actor) {
  if (!actor || actor.role !== 'admin' || actor.status !== 'active' || actor.deleted || !actor.uid)
    throw new FailoverError('forbidden',403);
}
export function initialFailoverState(now) {
  clock(now);
  return {format:FAILOVER_FORMAT,version:1,projectId:'samosval-offline',workspaceId:'main_workspace',
    enabled:false,mode:'synology',provider:'synology',epoch:1,revision:0,sequence:0,
    head:null,leaseUntil:0,healthySince:null,changedAt:now,changedBy:null,
    adapters:{synology:false,firebase:false},replicas:{synology:null,firebase:null}};
}
export function validateFailoverState(state) {
  if (!record(state) || state.format!==FAILOVER_FORMAT || state.version!==1 ||
      state.projectId!=='samosval-offline' || state.workspaceId!=='main_workspace' ||
      typeof state.enabled!=='boolean' || !MODES.includes(state.mode) ||
      !['synology','firebase'].includes(state.provider) || !integer(state.epoch) || state.epoch<1 ||
      !integer(state.revision) || !integer(state.sequence) || !integer(state.leaseUntil) ||
      !integer(state.changedAt) || !(state.healthySince===null || integer(state.healthySince)) ||
      !record(state.adapters) || !record(state.replicas)) fail('invalid-failover-state');
  for (const provider of ['synology','firebase']) {
    if (typeof state.adapters[provider]!=='boolean') fail('invalid-failover-state');
    const replica=state.replicas[provider];
    if (replica!==null && (!record(replica) || !integer(replica.sequence) || replica.sequence>state.sequence || !digest(replica.hash))) fail('invalid-failover-state');
  }
  if (state.head!==null && (!record(state.head) || !integer(state.head.sequence) ||
      state.head.sequence!==state.sequence || !digest(state.head.hash))) fail('invalid-failover-state');
  if (state.enabled && (!state.head || !state.adapters.synology || !state.adapters.firebase)) fail('invalid-failover-state');
  return state;
}
export function replicaReady(state,provider) {
  validateFailoverState(state);
  const replica=state.replicas[provider];
  return !!state.adapters[provider] && !!state.head && !!replica &&
    replica.sequence===state.sequence && replica.hash===state.head.hash;
}
export function writable(state,{provider,epoch,sequence,hash},now) {
  validateFailoverState(state); clock(now);
  return state.enabled && state.provider===provider && state.epoch===epoch &&
    state.sequence===sequence && state.head?.hash===hash && replicaReady(state,provider) &&
    (provider!=='synology' || state.leaseUntil>now);
}
function changed(state,patch,now,actor) {
  return {...state,...patch,revision:state.revision+1,changedAt:now,changedBy:actor?.uid||null};
}
function switchTo(state,provider,now,actor) {
  if (provider===state.provider) return state;
  if (!replicaReady(state,provider)) fail('replica-not-caught-up');
  return changed(state,{provider,epoch:state.epoch+1,leaseUntil:provider==='synology'?now+LEASE_MS:0,
    healthySince:null},now,actor);
}
// Trusted service initialization only. A browser cannot certify its own adapter
// or copy: these capabilities must be backed by actual integration checks.
export function prepareFailover(state,{adapters,checkpoint},now) {
  validateFailoverState(state); clock(now);
  if (state.enabled || state.head) fail('already-prepared');
  if (adapters?.synology!==true || adapters?.firebase!==true || !record(checkpoint) ||
      checkpoint.sequence!==0 || !digest(checkpoint.hash)) fail('verified-adapters-and-checkpoint-required');
  return changed(state,{enabled:true,head:{...checkpoint},adapters:{synology:true,firebase:true},
    replicas:{synology:{...checkpoint},firebase:{...checkpoint}},leaseUntil:now+LEASE_MS},now);
}
export function setFailoverMode(state,mode,{actor,expectedRevision},now) {
  validateFailoverState(state); clock(now); admin(actor);
  if (!MODES.includes(mode)) throw new FailoverError('invalid-failover-mode',400);
  if (expectedRevision!==state.revision) fail('failover-state-changed');
  if (!state.enabled) fail('failover-not-ready');
  let next=state;
  if (mode!=='auto') next=switchTo(state,mode,now,actor);
  if (next.mode===mode) return next;
  return changed(next,{mode},now,actor);
}
export function renewNasLease(state,proof,now) {
  validateFailoverState(state); clock(now);
  // An expired lease may be renewed only while the shared authority still
  // names this same epoch and head. A competing takeover wins the CAS.
  if (!state.enabled || state.provider!=='synology' || proof?.epoch!==state.epoch ||
      proof.sequence!==state.sequence || proof.hash!==state.head?.hash || !replicaReady(state,'synology'))
    fail('writer-fenced');
  return changed(state,{leaseUntil:now+LEASE_MS},now);
}
export function automaticFailover(state,{consecutiveFailures,online},now) {
  validateFailoverState(state); clock(now);
  if (!state.enabled || state.mode!=='auto' || state.provider!=='synology' ||
      !online || !integer(consecutiveFailures) || consecutiveFailures<3 || state.leaseUntil>now) return state;
  return switchTo(state,'firebase',now);
}
export function recordReplica(state,provider,{sequence,hash},now) {
  validateFailoverState(state); clock(now);
  if (!['synology','firebase'].includes(provider) || !state.head || sequence!==state.sequence || hash!==state.head.hash)
    fail('checkpoint-mismatch');
  return changed(state,{replicas:{...state.replicas,[provider]:{sequence,hash}}},now);
}
export function publishCommit(state,proof,{sequence,hash},now) {
  if (!writable(state,proof,now)) fail('writer-fenced');
  if (sequence!==state.sequence+1 || !digest(hash)) fail('invalid-next-checkpoint');
  const checkpoint={sequence,hash};
  // Publishing the immutable data and the head is one authority transaction.
  // The other provider is deliberately stale until it verifies this exact head.
  return changed(state,{sequence,head:checkpoint,
    replicas:{...state.replicas,[proof.provider]:checkpoint},
    leaseUntil:proof.provider==='synology'?now+LEASE_MS:0,healthySince:null},now);
}
export function observeNasRecovery(state,healthy,now) {
  validateFailoverState(state); clock(now);
  const since=healthy && replicaReady(state,'synology') ? state.healthySince??now : null;
  if (since===state.healthySince) return state;
  return changed(state,{healthySince:since},now);
}
export function automaticFailback(state,now) {
  validateFailoverState(state); clock(now);
  if (!state.enabled || state.mode!=='auto' || state.provider!=='firebase' ||
      state.healthySince===null || now-state.healthySince<RECOVERY_MS) return state;
  return switchTo(state,'synology',now);
}
