// TEST 4.1 emergency-only restore planner.
// Local device backups are proposals, NEVER authority to enable multi-user writes.
import {writable} from './failover-policy.mjs';

const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const validId=x=>typeof x==='string'&&x.length>0&&x.length<=160;
const same=(a,b)=>a===b;
const validHead=h=>h&&Number.isSafeInteger(h.sequence)&&h.sequence>=0&&sha(h.hash);
const stringified=x=>JSON.stringify(x);
const canonical=x=>stringified(sort(x));
function sort(v){
  if(Array.isArray(v))return v.map(sort);
  if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])]));
  return v;
}
// Reporting "staging-only" is intentional: device copies cannot prove that
// the last acknowledgement from a now-unreachable NAS was preserved.
export function assessEmergencyRestore({copies,expectedOperatorIds,projectId='samosval-offline',
  workspaceId='main_workspace',objectId,shiftId,now=Date.now(),maxAgeMs=24*60*60*1000}={}){
  const result=(status,details={})=>({status,readyForSharedWrites:false,cloudWritesAllowed:false,...details});
  if(projectId!=='samosval-offline'||workspaceId!=='main_workspace'||!validId(objectId)||!validId(shiftId)||
     !Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(maxAgeMs)||maxAgeMs<1)
    throw TypeError('invalid-emergency-scope');
  // An independently authenticated roster is required; the requesting device
  // cannot declare itself the only operator.
  if(!Array.isArray(expectedOperatorIds)||!expectedOperatorIds.length||
      expectedOperatorIds.some(x=>!validId(x))||
      new Set(expectedOperatorIds).size!==expectedOperatorIds.length)
    return result('blocked-unverified-roster');
  if(!Array.isArray(copies)||copies.length===0)return result('blocked-missing-devices',{missing:[...expectedOperatorIds]});
  const registered=new Set(expectedOperatorIds),seen=new Map();
  for(const copy of copies){
    if(!copy||!validId(copy.uid)||!registered.has(copy.uid)||seen.has(copy.uid)||
       copy.projectId!==projectId||copy.workspaceId!==workspaceId||copy.provider!=='synology'||
       !same(copy.objectId,objectId)||!same(copy.shiftId,shiftId)||
       !validHead(copy.head)||!Number.isSafeInteger(copy.savedAt)||copy.savedAt>now||
       now-copy.savedAt>maxAgeMs||!Array.isArray(copy.pendingOperations))
      return result('blocked-invalid-device-copy');
    seen.set(copy.uid,copy);
  }
  const missing=expectedOperatorIds.filter(uid=>!seen.has(uid));
  if(missing.length)return result('blocked-missing-devices',{missing});
  const heads=[...seen.values()].map(c=>c.head);
  if(heads.some(h=>h.sequence!==heads[0].sequence||h.hash!==heads[0].hash))
    return result('blocked-divergent-heads');
  const operations=new Map();
  for(const copy of seen.values()){
    for(const op of copy.pendingOperations){
      // Original operation IDs and exact NAS scope must be preserved for later
      // reconciliation; nothing here is replayed or marked confirmed.
      if(!op||!validId(op.id)||op.provider!=='synology'||op.projectId!==projectId||
         op.workspaceId!==workspaceId||op.objectId!==objectId||op.shiftId!==shiftId||
         !validId(op.uid)||op.uid!==copy.uid||!op.body||typeof op.body!=='object'||
         Array.isArray(op.body))return result('blocked-invalid-operation');
      let serial;
      try{serial=canonical(op);}catch{return result('blocked-invalid-operation');}
      if(operations.has(op.id)&&operations.get(op.id)!==serial)return result('blocked-operation-id-conflict');
      operations.set(op.id,serial);
    }
  }
  return result('staging-only',{
    head:{sequence:heads[0].sequence,hash:heads[0].hash},
    contributingOperators:seen.size,
    pendingOperationCount:operations.size,
    reason:'NAS tail and receipts require independent authoritative verification'
  });
}
// Any Firebase business write must independently pass shared epoch/authority
// checks AND a live backend verification. A phone snapshot never grants writes.
export function permitFirebaseEmergencyWrite({phase,state,proof,now,liveAdapterVerified=false}={}){
  if(phase!=='emergency-active'||liveAdapterVerified!==true||
     proof?.provider!=='firebase'||!state||!Number.isSafeInteger(now)||now<0)return false;
  try{return writable(state,proof,now);}catch{return false;}
}
